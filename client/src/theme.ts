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

/** 把可能带透明度的颜色与实色底混合，得到不透明颜色。 */
export function opaqueColor(color: string, fallbackBase: string): string {
	const parse = (value: string): [number, number, number, number] | null => {
		const match = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
		if (!match) return null;
		const parts = match[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
		if (parts.length < 3 || parts.some((item) => Number.isNaN(item))) return null;
		return [parts[0]!, parts[1]!, parts[2]!, parts.length > 3 ? parts[3]! : 1];
	};
	const foreground = parse(color);
	const base = parse(fallbackBase) ?? [255, 255, 255, 1];
	if (!foreground) return fallbackBase;
	const alpha = Math.min(Math.max(foreground[3], 0), 1);
	const mix = (value: number, under: number) => Math.round(value * alpha + under * (1 - alpha));
	return `rgb(${mix(foreground[0], base[0])}, ${mix(foreground[1], base[1])}, ${mix(foreground[2], base[2])})`;
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
