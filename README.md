# zero-db-tool

DeepSeek Harness 的数据库工作台：连接下拉 + 对象树 + 数据/结构/SQL 三页，只读优先。

- **模型侧**：`sql_query` / `sql_exec` / `sql_schema` / `sql_stats` / `sql_health` / `sql_connections`
- **界面侧**：右侧栏 DBeaver 风格工作台——连接下拉、可拖拽对象树（库 → 表/视图）、数据/结构/SQL 页签、CSV 导出、SQL 历史、双击单元格复制
- **引擎**：SQLite / PostgreSQL / MySQL
- **数据**：`<我的文档>/DSH/zero-db-tool`（`ZERO_DB_TOOL_DIR` 可覆盖），密码 AES-256-GCM 加密

## 安装

本地目录（当前方式）：

```bash
dsh plugin --profile web add "link:D:\\kaifawork\\AIWORK\\zero-db-tool"
```

私有仓库：

```bash
git clone https://github.com/zerui-chen/zero-db-tool.git
dsh plugin --profile web add "link:<克隆目录>"
```

安装后完全退出并重启 DSH。

## 工具

| 工具 | 行为 |
| --- | --- |
| `sql_query` | 单条只读语句（SELECT / PRAGMA / EXPLAIN / SHOW / DESCRIBE / WITH），拒绝多语句、锁读、`SELECT ... INTO`、写型 PRAGMA |
| `sql_exec` | 只允许 INSERT / UPDATE；含 UPDATE 时在调用内向用户请求批准，拒绝则不执行；DELETE / DDL / 事务一律拒绝 |
| `sql_schema` | 列出表与视图，或描述一张表的列（三种引擎通用） |
| `sql_stats` | 表数量、逐表行数（最多 100 张）、SQLite 文件大小 |
| `sql_health` | 逐连接探活与治理摘要 |
| `sql_connections` | list / add / remove / test |

## 界面

- **连接**：顶部下拉切换；测试、编辑、删除在右侧
- **对象树**：宽屏常驻且可拖拽（20%–55%），按钮可隐藏；窄于 560px 自动改为抽屉，选表后关闭
- **数据**：行号、PK 标记、斑马纹、悬停高亮、分页、CSV 导出、双击复制
- **结构**：字段 / 类型 / 约束（主键、可空）
- **SQL**：等宽编辑器、Ctrl+Enter、历史回填、结果 CSV、只读单语句

MySQL / 未配置默认库的 PostgreSQL 在树里先列库，展开某个库时才按库拉表。

## 安全模型

| 层次 | 机制 |
| --- | --- |
| 读 | 词法闸门只放行只读语句；单语句；拒绝写型构造 |
| 写 | 仅 INSERT / UPDATE；UPDATE 逐批人工批准；DELETE / DDL / 事务 / 权限语句永不执行 |
| 凭据 | AES-256-GCM 加密文件（0600），密钥由用户名 + 主机名 + 数据目录派生；列表与导出不回显密码 |
| 传输 | 密码可走本地加密 / 本次运行 / 环境变量三种模式 |
| HTTP | 仅接受 loopback 或受信 Host，Origin/Referer 同源校验；宿主提供鉴权时优先采用 |

## 与 dsh-db-tool 共存

两者连接库互相独立，工具名不冲突（`sql_*` vs `DatabaseManager`）。本插件更窄：三种引擎、默认只读、无数据传输/审计/事务。

## 数据目录

```
<Documents>/DSH/zero-db-tool/
  connections.json   连接定义（密码只存引用）
  credentials.enc    加密凭据库（0600）
```

## 开发

```bash
npm install
npm run build      # tsc + esbuild 客户端单文件
npm test           # vitest
node --check client/client.js
```

## 已知限制

- 无审计日志、事务、数据传输
- SQL 编辑器是 antd 文本域，没有语法高亮与补全
- 表行数统计对超大库可能较慢（最多扫 100 张表）

## 许可证

BSD-3-Clause。
