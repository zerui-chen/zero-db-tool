/**
 * 本插件只依赖宿主暴露的四个服务；这里给出结构化最小类型，
 * 避免把 @deepseek-ai/cordis 变成编译期硬依赖。
 */
export type PluginContext = {
	tools?: {
		register: (tool: {
			name: string;
			timeoutMs?: number;
			description: string;
			parameters: Record<string, unknown>;
			output: Record<string, unknown>;
			execute: (args: never, exec?: { agent?: unknown; signal?: AbortSignal }) => Promise<unknown>;
		}) => void;
	};
	webServer?: {
		register: (options: { kind: "prefix"; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => (() => void) | void;
		host?: string;
		port?: number;
	};
	sessions?: { get: (id: string) => { header?: { cwd?: string } } | undefined };
	connection?: { requestRejection?: (req: unknown) => number | undefined };
	get?: (name: string, optional?: boolean) => unknown;
	effect?: (fn: () => unknown, label?: string) => void;
	logger?: { info?: (message: string) => void; error?: (message: string) => void };
};
