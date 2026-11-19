/** 从宿主 CSS 变量解析出 antd 需要的具体颜色值。 */
export function resolveColor(name: string, fallback: string): string {
	try {
		const probe = document.createElement("div");
		probe.style.color = `var(${name})`;
		probe.style.display = "none";
		document.body.appendChild(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color && color !== "rgba(0, 0, 0, 0)" ? color : fallback;
	} catch {
		return fallback;
	}
}

export function isDarkTheme(): boolean {
	try {
		const scheme = getComputedStyle(document.documentElement).colorScheme;
		if (scheme.includes("dark")) return true;
		if (scheme.includes("light")) return false;
		return window.matchMedia("(prefers-color-scheme: dark)").matches;
	} catch {
		return false;
	}
}
