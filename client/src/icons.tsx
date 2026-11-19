/** 用内联 SVG 替代 @remixicon/react，避免给宿主增加客户端依赖。 */
import React from "react";

type IconProps = { size?: number; "aria-hidden"?: boolean | "true" | "false" };

function icon(path: React.ReactNode, props: IconProps) {
	const size = props.size ?? 16;
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
			strokeLinecap="round" strokeLinejoin="round" aria-hidden={props["aria-hidden"] ?? "true"}>
			{path}
		</svg>
	);
}

export function RiDatabase2Line(props: IconProps) {
	return icon(<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>, props);
}
export function RiDownload2Line(props: IconProps) {
	return icon(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 19h16" /></>, props);
}
export function RiUpload2Line(props: IconProps) {
	return icon(<><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M4 19h16" /></>, props);
}
export function RiPlayLine(props: IconProps) {
	return icon(<path d="M7 4.5v15l12-7.5-12-7.5Z" />, props);
}
export function RiRefreshLine(props: IconProps) {
	return icon(<><path d="M20 11a8 8 0 1 0-2.3 6.3" /><path d="M20 4v7h-7" /></>, props);
}
export function RiShieldCheckLine(props: IconProps) {
	return icon(<><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>, props);
}
