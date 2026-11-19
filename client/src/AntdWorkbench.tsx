/**
 * DBeaver / Navicat 式右侧栏工作台：连接下拉 + 对象树 + 数据/结构/SQL。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	App, Button, Card, Dropdown, Empty, Flex, Form, Input, InputNumber, Modal, Popconfirm,
	Drawer, Radio, Select, Space, Splitter, Switch, Table, Tabs, Tag, Tooltip, Tree, Typography, theme,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { DataNode } from "antd/es/tree";
import {
	ApartmentOutlined, ClearOutlined, CodeOutlined, CopyOutlined, DatabaseOutlined, DeleteOutlined, DownloadOutlined,
	EditOutlined, EyeOutlined, MoreOutlined, PlayCircleOutlined, PlusOutlined, ProfileOutlined,
	ReloadOutlined, SearchOutlined, TableOutlined, ThunderboltOutlined,
} from "@ant-design/icons";
import { api, type ColumnSummary, type Connection, type DbEngine, type TablePage, type TableSummary } from "./api";

const { Text } = Typography;
const HISTORY_KEY = "zero-db-tool.sql-history";
const ENGINE: Record<DbEngine, { label: string; color: string }> = {
	sqlite: { label: "SQLite", color: "#2f8e6f" },
	postgres: { label: "PostgreSQL", color: "#3b82f6" },
	mysql: { label: "MySQL", color: "#d97706" },
};

type Health = { ok: boolean; ms?: number; message?: string };
type FormValues = {
	name: string; engine: DbEngine; path?: string; mode?: "parameters" | "url-env"; urlEnv?: string;
	host?: string; port?: number; database?: string; username?: string;
	passwordMode?: "encrypted" | "runtime" | "environment"; password?: string; passwordEnv?: string; ssl?: boolean;
};
type TableResult = { columns: string[]; rows: Array<Record<string, unknown>>; rowCount: number; truncated: boolean };

function cell(value: unknown): string {
	if (value === null) return "NULL";
	if (value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}
function targetOf(connection: Connection): string {
	if (connection.engine === "sqlite") return connection.path ?? "";
	return (connection.host ?? "") + (connection.port ? ":" + connection.port : "") + (connection.database ? " / " + connection.database : "");
}
function csvOf(columns: string[], rows: Array<Record<string, unknown>>): string {
	const escape = (value: unknown) => {
		const text = cell(value);
		return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
	};
	return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
}
function download(name: string, text: string, type?: string): void {
	const blob = new Blob(["\ufeff" + text], { type: type ?? "text/csv;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name;
	anchor.click();
	URL.revokeObjectURL(url);
}

export function AntdWorkbench(): React.JSX.Element {
	const { message } = App.useApp();
	const { token } = theme.useToken();
	const [connections, setConnections] = useState<Connection[]>([]);
	const [activeName, setActiveName] = useState("");
	const [health, setHealth] = useState<Record<string, Health>>({});
	const [databases, setDatabases] = useState<string[]>([]);
	const [tablesByDb, setTablesByDb] = useState<Record<string, TableSummary[]>>({});
	const [database, setDatabase] = useState("");
	const [table, setTable] = useState("");
	const [pageSize, setPageSize] = useState(50);
	const [page, setPage] = useState<TablePage | null>(null);
	const [mode, setMode] = useState<"data" | "schema" | "sql">("data");
	const [sql, setSql] = useState("");
	const [result, setResult] = useState<TableResult | null>(null);
	const [loading, setLoading] = useState("");
	const [search, setSearch] = useState("");
	const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
	const [formOpen, setFormOpen] = useState(false);
	const [editing, setEditing] = useState<Connection | null>(null);
	const [history, setHistory] = useState<string[]>([]);
	const [version, setVersion] = useState("");
	const [narrow, setNarrow] = useState(false);
	const [treeOpen, setTreeOpen] = useState(true);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const appRef = useRef<HTMLDivElement>(null);
	const [form] = Form.useForm<FormValues>();
	const fileRef = useRef<HTMLInputElement>(null);
	const engine = Form.useWatch("engine", form) ?? "sqlite";
	const passwordMode = Form.useWatch("passwordMode", form) ?? "encrypted";
	const connectMode = Form.useWatch("mode", form) ?? "parameters";

	const active = useMemo(() => connections.find((item) => item.name === activeName), [connections, activeName]);

	useEffect(() => {
		try { setHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as string[]); } catch { setHistory([]); }
		void api.version().then((payload) => setVersion(payload.version)).catch(() => setVersion(""));
	}, []);

	const pushHistory = useCallback((statement: string) => {
		const text = statement.trim();
		if (!text) return;
		setHistory((current) => {
			const next = [text, ...current.filter((item) => item !== text)].slice(0, 8);
			try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
			return next;
		});
	}, []);

	const loadConnections = useCallback(async () => {
		setLoading("connections");
		try {
			const payload = await api.list();
			setConnections(payload.connections ?? []);
		} catch (cause) {
			message.error(cause instanceof Error ? cause.message : String(cause));
		} finally { setLoading(""); }
	}, [message]);

	useEffect(() => { void loadConnections(); }, [loadConnections]);

	useEffect(() => {
		const node = appRef.current;
		if (!node || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? node.clientWidth;
			setNarrow(width < 560);
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	const loadTable = useCallback(async (name: string, db: string, tableName: string, nextPage = 1, size = pageSize) => {
		setLoading("rows");
		try {
			const payload = await api.browse(name, tableName, nextPage, size, db || undefined);
			setPage(payload.result);
			setTable(tableName);
			setDatabase(db);
		} catch (cause) {
			message.error(cause instanceof Error ? cause.message : String(cause));
		} finally { setLoading(""); }
	}, [message, pageSize]);

	const selectConnection = useCallback(async (name: string) => {
		const connection = connections.find((item) => item.name === name);
		if (!connection) return;
		setActiveName(name);
		setPage(null); setResult(null); setTablesByDb({}); setDatabase(""); setTable(""); setSearch("");
		setLoading("catalog");
		try {
			const payload = await api.catalog(name, connection.database ?? undefined);
			const dbs = payload.databases ?? [];
			const configured = (connection.database ?? '').trim();
			// 服务级连接（MySQL / 未指定库的 PostgreSQL）只列库，表在展开时按库懒加载。
			const serverLevel = (connection.engine === 'mysql' || connection.engine === 'postgres') && configured === '';
			const db = configured !== '' ? configured : (dbs.length === 1 ? dbs[0] ?? '' : '');
			setDatabases(dbs.length > 0 ? dbs : ['']);
			setDatabase(db);
			if (serverLevel) {
				setTablesByDb({});
				setExpandedKeys([]);
			} else {
				setExpandedKeys((dbs.length > 0 ? dbs : ['']).map((item) => 'db:' + item));
				setTablesByDb({ [db]: payload.tables ?? [] });
				const first = (payload.tables ?? [])[0];
				if (first) await loadTable(name, db, first.name, 1, pageSize);
			}
		} catch (cause) {
			message.error(cause instanceof Error ? cause.message : String(cause));
		} finally { setLoading(""); }
	}, [connections, loadTable, message, pageSize]);

	async function testConnection(connection: Connection) {
		try {
			const payload = await api.test(connection.name);
			setHealth((current) => ({ ...current, [connection.name]: { ok: true, ms: payload.result?.elapsedMs } }));
			message.success(connection.name + " 可用");
		} catch (cause) {
			const text = cause instanceof Error ? cause.message : String(cause);
			setHealth((current) => ({ ...current, [connection.name]: { ok: false, message: text } }));
			message.error(text);
		}
	}

	async function removeConnection(connection: Connection) {
		try {
			await api.remove(connection.name);
			message.success("已删除 " + connection.name);
			if (activeName === connection.name) { setActiveName(""); setPage(null); setDatabases([]); setTablesByDb({}); }
			await loadConnections();
		} catch (cause) {
			message.error(cause instanceof Error ? cause.message : String(cause));
		}
	}

	function openCreate() {
		setEditing(null);
		form.resetFields();
		form.setFieldsValue({ engine: "sqlite", passwordMode: "encrypted", mode: "parameters", host: "127.0.0.1", ssl: false });
		setFormOpen(true);
	}
	function openEdit(connection: Connection) {
		setEditing(connection);
		form.setFieldsValue({
			name: connection.name, engine: connection.engine, path: connection.path,
			mode: connection.mode ?? "parameters", urlEnv: connection.urlEnv, host: connection.host,
			port: connection.port, database: connection.database, username: connection.username,
			passwordMode: connection.passwordMode ?? "runtime", passwordEnv: connection.passwordEnv, ssl: connection.ssl,
		});
		setFormOpen(true);
	}

	async function save() {
		const values = await form.validateFields();
		const body: Record<string, unknown> = values.engine === "sqlite"
			? { name: values.name, engine: "sqlite", path: values.path }
			: values.mode === "url-env"
				? { name: values.name, engine: values.engine, mode: "url-env", urlEnv: values.urlEnv }
				: {
					name: values.name, engine: values.engine, mode: "parameters",
					host: values.host, port: values.port, database: values.database, username: values.username,
					passwordMode: values.passwordMode, ssl: values.ssl === true,
					...(values.passwordMode === "environment" ? { passwordEnv: values.passwordEnv } : (values.password ? { password: values.password } : {})),
				};
		setLoading("save");
		try {
			if (editing) await api.update(editing.name, body);
			else await api.add(body);
			message.success(editing ? "连接已更新" : "连接已保存");
			setFormOpen(false);
			await loadConnections();
		} catch (cause) {
			message.error(cause instanceof Error ? cause.message : String(cause));
		} finally { setLoading(""); }
	}

	async function exportConnections() {
		try {
			const payload = await api.exportAll();
			download("zero-db-tool-connections-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(payload.document, null, 2) + "\n", "application/json");
			message.success("已导出（不含密码）");
		} catch (cause) {
			message.error(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function importConnections(file: File) {
		try {
			const document_ = JSON.parse(await file.text());
			const payload = await api.importAll(document_, "skip");
			message.success("导入完成：新增 " + payload.result.imported + "，跳过 " + payload.result.skipped);
			await loadConnections();
		} catch (cause) {
			message.error(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function runSql() {
		if (!active || sql.trim() === "") return;
		setLoading("sql");
		setResult(null);
		try {
			const payload = await api.query(active.name, sql, database || undefined);
			setResult(payload.result);
			pushHistory(sql);
		} catch (cause) {
			message.error(cause instanceof Error ? cause.message : String(cause));
		} finally { setLoading(""); }
	}

	function copyValue(value: unknown) {
		const text = cell(value);
		if (text === "" || text === "NULL") return;
		void navigator.clipboard?.writeText(text).then(() => message.success("已复制"));
	}

	async function expandDatabase(key: string) {
		if (!active) return;
		if (tablesByDb[key] !== undefined) return;
		try {
			const payload = await api.catalog(active.name, key || undefined);
			setTablesByDb((current) => ({ ...current, [key]: payload.tables ?? [] }));
		} catch (cause) {
			message.error(cause instanceof Error ? cause.message : String(cause));
		}
	}

	const treeData: DataNode[] = useMemo(() => {
		const query = search.trim().toLowerCase();
		const nodes: DataNode[] = [];
		for (const db of databases) {
			const tables = tablesByDb[db] ?? [];
			const visible = query === "" ? tables : tables.filter((item) => item.name.toLowerCase().includes(query));
			if (query !== "" && visible.length === 0) continue;
			const loaded = tablesByDb[db] !== undefined;
			nodes.push({
				key: 'db:' + db,
				title: db === '' ? '(默认库)' : db,
				icon: <DatabaseOutlined />,
				selectable: false,
				isLeaf: false,
				...(loaded ? { children: visible.map((item) => ({
					key: 'tb:' + db + ':' + item.name,
					title: item.name,
					icon: item.type === 'view' ? <EyeOutlined /> : <TableOutlined />,
					isLeaf: true,
				})) } : {}),
			});

		}
		return nodes;
	}, [databases, tablesByDb, search]);

	const dataColumns: ColumnsType<Record<string, unknown>> = useMemo(() => {
		const columns: ColumnSummary[] = page?.columns ?? [];
		if (columns.length > 0) {
			const mapped = columns.map((column) => ({
				title: <Space size={4}><span>{column.name}</span>{column.primaryKey ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>PK</Tag> : null}</Space>,
				dataIndex: column.name, key: column.name, ellipsis: true,
				render: (value: unknown) => <span onDoubleClick={() => copyValue(value)} title={cell(value)}>{cell(value)}</span>,
			}));
			return [{ title: "#", key: "__row", width: 42, render: (_: unknown, __: unknown, index: number) => <span className="dbw-rownum">{index + 1}</span> }, ...mapped];
		}
		const keys = page?.rows[0] ? Object.keys(page.rows[0]) : [];
		return keys.map((key) => ({ title: key, dataIndex: key, key, ellipsis: true, render: (value: unknown) => cell(value) }));
	}, [page]);

	const sqlColumns: ColumnsType<Record<string, unknown>> = useMemo(() => {
		const keys = result?.columns.length ? result.columns : (result?.rows[0] ? Object.keys(result.rows[0]) : []);
		return keys.map((key) => ({ title: key, dataIndex: key, key, ellipsis: true, render: (value: unknown) => <span onDoubleClick={() => copyValue(value)}>{cell(value)}</span> }));
	}, [result]);

	const schemaColumns: ColumnsType<ColumnSummary> = [
		{ title: "字段", dataIndex: "name", key: "name", width: 130 },
		{ title: "类型", dataIndex: "type", key: "type", render: (value: string) => value || "未知类型" },
		{ title: "约束", key: "constraint", render: (_: unknown, column: ColumnSummary) => [column.primaryKey ? "主键" : "", column.nullable ? "可空" : "非空"].filter(Boolean).join(" · ") },
	];

	const dataKeys = dataColumns.map((column) => String(column.dataIndex ?? "")).filter((key) => key !== "__row");
	const activeMeta = active ? ENGINE[active.engine] : null;
	const state = active ? health[active.name] : undefined;

	const tabItems = [
		{
			key: "data",
			label: <Space size={4}><TableOutlined />数据</Space>,
			children: (
				<Flex vertical gap={8} style={{ height: "100%" }}>
					<div className="dbw-grid-wrap">
					<Table
						size="small" bordered sticky rowKey={(_, index) => String(index)} columns={dataColumns}
						dataSource={page?.rows ?? []} pagination={false} scroll={{ x: "max-content" }} loading={loading === "rows"}
						locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={table ? "没有数据" : (narrow ? "点击「对象」选择表" : "从左侧选择表或视图")} /> }}
					/>
					</div>
					{page ? (
						<Flex justify="space-between" align="center">
							<Text type="secondary">第 {page.page} 页 · 本页 {page.rows.length} 行</Text>
							<Space size={4}>
								<Button size="small" disabled={page.page <= 1 || loading === "rows"} onClick={() => void loadTable(activeName, database, table, page.page - 1, pageSize)}>上一页</Button>
								<Button size="small" disabled={!page.hasNext || loading === "rows"} onClick={() => void loadTable(activeName, database, table, page.page + 1, pageSize)}>下一页</Button>
							</Space>
						</Flex>
					) : null}
				</Flex>
			),
		},
		{
			key: "schema",
			label: <Space size={4}><ProfileOutlined />结构</Space>,
			children: (
				<Table size="small" bordered pagination={false} rowKey="name" dataSource={page?.columns ?? []} columns={schemaColumns}
					locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从左侧选择表或视图" /> }} />
			),
		},
		{
			key: "sql",
			label: <Space size={4}><CodeOutlined />SQL</Space>,
			children: (
				<Flex vertical gap={8} className="dbw-sql">
					<Input.TextArea
						rows={7} value={sql} onChange={(event) => setSql(event.target.value)} spellCheck={false}
						placeholder={"SELECT *\nFROM table_name\nLIMIT 50"}
						onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void runSql(); } }}
					/>
					<Flex justify="space-between" align="center" gap={8} wrap>
						<Space size={6}>
							<Button type="primary" size="small" icon={<PlayCircleOutlined />} loading={loading === "sql"} disabled={!sql.trim()} onClick={() => void runSql()}>执行</Button>
							<Text type="secondary" style={{ fontSize: 11 }}>只读单条 · Ctrl+Enter</Text>
						</Space>
						<Space size={0}>
							<Tooltip title="清空"><Button size="small" type="text" icon={<ClearOutlined />} onClick={() => { setSql(""); setResult(null); }} /></Tooltip>
							<Tooltip title="复制 SQL"><Button size="small" type="text" icon={<CopyOutlined />} onClick={() => { void navigator.clipboard?.writeText(sql); message.success("已复制 SQL"); }} /></Tooltip>
						</Space>
					</Flex>
					{history.length > 0 ? (
						<Flex gap={4} wrap align="center">
							<Text type="secondary" style={{ fontSize: 11 }}>历史</Text>
							{history.slice(0, 5).map((item) => (
								<Tag key={item} style={{ cursor: "pointer", maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis" }} onClick={() => setSql(item)} title={item}>
									{item.replace(/\s+/g, " ").slice(0, 36)}
								</Tag>
							))}
						</Flex>
					) : null}
					{result ? (
						<Flex vertical gap={6}>
							<Flex justify="space-between" align="center">
								<Space size={6}>
									<Tag color="blue">{result.rowCount} 行</Tag>
									{result.truncated ? <Tag color="orange">已截断</Tag> : null}
								</Space>
								<Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => download(activeName + "-query.csv", csvOf(result.columns.length ? result.columns : Object.keys(result.rows[0] ?? {}), result.rows))}>CSV</Button>
							</Flex>
							<Table size="small" bordered rowKey={(_, index) => String(index)} columns={sqlColumns} dataSource={result.rows} pagination={false} scroll={{ x: "max-content" }} />
						</Flex>
					) : null}
				</Flex>
			),
		},
	];

	const treeContent = (
		<>
						<div className="dbw-tree-head">
							<span className="dbw-section-label">对象</span>
							<Input size="small" variant="filled" allowClear prefix={<SearchOutlined />} placeholder="搜索表" value={search} onChange={(event) => setSearch(event.target.value)} />
						</div>
						<div className="dbw-tree-body">
							<Tree
								blockNode showIcon treeData={treeData} selectedKeys={active && table ? ["tb:" + database + ":" + table] : []}
								expandedKeys={search.trim() !== "" ? databases.map((db) => "db:" + db) : expandedKeys}
								onSelect={(keys) => {
									const key = String(keys[0] ?? "");
									if (!key.startsWith("tb:")) return;
									const rest = key.slice(3);
									const separator = rest.indexOf(":");
									setMode("data");
									if (narrow) setDrawerOpen(false);
									void loadTable(activeName, rest.slice(0, separator), rest.slice(separator + 1), 1, pageSize);
								}}
								onExpand={(keys) => { setExpandedKeys(keys); for (const key of keys) void expandDatabase(String(key).slice(3)); }}
							/>
						</div>
		</>
	);

	const mainPane = (
					<div className="dbw-main">
						<div className="dbw-main-head">
							<div className="dbw-main-title">
								<Tooltip title={narrow ? "对象树" : treeOpen ? "隐藏对象树" : "显示对象树"}>
									<Button size="small" type="text" aria-label="对象" icon={<ApartmentOutlined />} onClick={() => { if (narrow) setDrawerOpen(true); else setTreeOpen(!treeOpen); }}>{narrow ? "对象" : null}</Button>
								</Tooltip>
								<div>
									<span className="dbw-table-name">{table || "选择表或视图"}</span>
									<span className="dbw-table-path">{database ? database + " / " : ""}{table || "从对象树选择"}</span>
								</div>
							</div>
							<Space size={2}>
								<Select size="small" variant="borderless" style={{ width: 76 }} value={pageSize}
									options={[20, 50, 100].map((size) => ({ value: size, label: size + "/页" }))}
									onChange={(size) => { setPageSize(size); if (table) void loadTable(activeName, database, table, 1, size); }} />
								<Tooltip title="刷新"><Button size="small" type="text" icon={<ReloadOutlined />} disabled={!table} onClick={() => void loadTable(activeName, database, table, page?.page ?? 1, pageSize)} /></Tooltip>
								<Tooltip title="导出 CSV"><Button size="small" type="text" icon={<DownloadOutlined />} disabled={!page || page.rows.length === 0} onClick={() => page && download(activeName + "-" + page.table + ".csv", csvOf(dataKeys, page.rows))} /></Tooltip>
							</Space>
						</div>
						<Tabs activeKey={mode} onChange={(key) => setMode(key as "data" | "schema" | "sql")} items={tabItems} size="small" />
					</div>
	);

	return (
		<div className="dbw-app" ref={appRef}>
<div className="dbw-topbar">
  <div className="dbw-brand">
    <span className="dbw-logo"><DatabaseOutlined /></span>
    <div>
      <span className="dbw-title">数据库工作台</span>
      <span className="dbw-subtitle">
      {active && activeMeta ? (
        <>
          <i className="dbw-dot" style={{ background: activeMeta.color }} />
          {activeMeta.label + " · " + targetOf(active)}
          {state?.ok ? <span className="dbw-ok"> · {state.ms !== undefined ? state.ms + "ms" : "OK"}</span> : null}
          {state && !state.ok ? <span className="dbw-bad"> · 不可用</span> : null}
        </>
      ) : (
        connections.length + " 个连接 · 只读优先"
      )}
    </span>
    </div>
  </div>
  <Space size={2}>
    <Tooltip title="刷新连接"><Button size="small" type="text" icon={<ReloadOutlined />} loading={loading === "connections"} onClick={() => void loadConnections()} /></Tooltip>
    <Dropdown menu={{ items: [
      { key: "version", label: "插件 " + (version ? "v" + version : "版本未知"), disabled: true },
      { type: "divider" as const },
      { key: "import", label: "导入连接", icon: <DownloadOutlined />, onClick: () => fileRef.current?.click() },
      { key: "export", label: "导出连接", icon: <DownloadOutlined />, onClick: () => void exportConnections() },
    ] }}>
      <Button size="small" type="text" icon={<MoreOutlined />} />
    </Dropdown>
    <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建</Button>
  </Space>
</div>
<div className="dbw-connbar">
  <Select
    size="middle" variant="filled" style={{ flex: 1, minWidth: 0 }} placeholder="选择连接"
    value={activeName || undefined} onChange={(value) => void selectConnection(value)}
    options={connections.map((connection) => ({ value: connection.name, label: connection.name + " · " + ENGINE[connection.engine].label }))}
    notFoundContent={<Text type="secondary">还没有连接</Text>}
  />
  {active ? (
    <>
      <Tooltip title="测试连接"><Button size="small" type="text" icon={<ThunderboltOutlined />} onClick={() => void testConnection(active)} /></Tooltip>
      <Tooltip title="编辑连接"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(active)} /></Tooltip>
      <Popconfirm title={"删除 " + active.name + "？"} onConfirm={() => void removeConnection(active)} okText="删除" cancelText="取消">
        <Button size="small" type="text" danger icon={<DeleteOutlined />} />
      </Popconfirm>
    </>
  ) : null}
</div>

						<input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importConnections(file); event.target.value = ""; }} />

			{active ? (
				narrow ? (
					<div className="dbw-workarea">
						{mainPane}
						<Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} placement="left" width={280} title="对象" styles={{ body: { padding: 0 } }}>
							<div className="dbw-tree dbw-tree-drawer">{treeContent}</div>
						</Drawer>
					</div>
				) : treeOpen ? (
					<Splitter className="dbw-splitter">
						<Splitter.Panel defaultSize="32%" min="20%" max="55%">
							<div className="dbw-tree">{treeContent}</div>
						</Splitter.Panel>
						<Splitter.Panel min="20%">{mainPane}</Splitter.Panel>
					</Splitter>
				) : (
					<div className="dbw-workarea">{mainPane}</div>
				)
			) : (
				<div className="dbw-empty-wrap">
					<Card size="small" className="dbw-card" styles={{ body: { padding: 8 } }}>
						<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择或新建一个连接">
							<Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建连接</Button>
						</Empty>
					</Card>
				</div>
			)}


			<div className="dbw-footer">
				<span>{active ? ENGINE[active.engine].label : "未连接"}</span>
				<span>{active ? active.name : ""}</span>
				<span className="dbw-footer-grow" />
				<span>{page ? page.rows.length + " 行 / 页" : ""}</span>
				<span>只读</span>
			</div>
			<Modal
				open={formOpen} title={editing ? "编辑 " + editing.name : "新增连接"} okText="保存" cancelText="取消"
				confirmLoading={loading === "save"} onOk={() => void save()} onCancel={() => setFormOpen(false)}
				destroyOnHidden width="min(560px, calc(100vw - 24px))"
			>
				<Form form={form} layout="vertical" preserve={false}>
					<Form.Item name="name" label="连接名称" rules={[{ required: true, message: "请输入连接名称" }]}>
						<Input placeholder="例如：订单生产库" />
					</Form.Item>
					<Form.Item name="engine" label="数据库类型">
						<Radio.Group optionType="button" buttonStyle="solid" size="middle">
							<Radio.Button value="sqlite">SQLite</Radio.Button>
							<Radio.Button value="postgres">PostgreSQL</Radio.Button>
							<Radio.Button value="mysql">MySQL</Radio.Button>
						</Radio.Group>
					</Form.Item>
					{engine === "sqlite" ? (
						<Form.Item name="path" label="数据库文件绝对路径" rules={[{ required: true, message: "请输入数据库文件路径" }]}>
							<Input placeholder="D:\\data\\app.db" />
						</Form.Item>
					) : (
						<>
							<Form.Item name="mode" label="连接方式">
								<Radio.Group>
									<Radio.Button value="parameters">地址和账号</Radio.Button>
									<Radio.Button value="url-env">DSN 环境变量</Radio.Button>
								</Radio.Group>
							</Form.Item>
							{connectMode === "url-env" ? (
								<Form.Item name="urlEnv" label="完整 DSN 环境变量名" rules={[{ required: true }]}>
									<Input placeholder="DATABASE_URL" />
								</Form.Item>
							) : (
								<>
									<Flex gap={8}>
										<Form.Item name="host" label="主机地址" rules={[{ required: true }]} style={{ flex: 1 }}>
											<Input placeholder="127.0.0.1" />
										</Form.Item>
										<Form.Item name="port" label="端口" style={{ width: 110 }}>
											<InputNumber min={1} max={65535} placeholder={engine === "postgres" ? "5432" : "3306"} style={{ width: "100%" }} />
										</Form.Item>
									</Flex>
									<Form.Item name="database" label="数据库名"><Input placeholder="留空使用默认库" /></Form.Item>
									<Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
									<Form.Item name="passwordMode" label="密码保存方式">
										<Radio.Group>
											<Radio value="encrypted">本地加密</Radio>
											<Radio value="runtime">本次运行</Radio>
											<Radio value="environment">环境变量</Radio>
										</Radio.Group>
									</Form.Item>
									{passwordMode === "environment" ? (
										<Form.Item name="passwordEnv" label="密码环境变量名" rules={[{ required: true }]}>
											<Input placeholder="DB_PASSWORD" />
										</Form.Item>
									) : (
										<Form.Item name="password" label={editing ? "密码（留空不修改）" : "密码"} rules={editing ? [] : [{ required: true, message: "请输入密码" }]}>
											<Input.Password placeholder={passwordMode === "runtime" ? "仅保存在当前进程内存" : "AES-256-GCM 加密保存"} />
										</Form.Item>
									)}
									<Form.Item name="ssl" label="启用 SSL/TLS" valuePropName="checked"><Switch size="small" /></Form.Item>
								</>
							)}
						</>
					)}
				</Form>
			</Modal>
		</div>
	);
}
