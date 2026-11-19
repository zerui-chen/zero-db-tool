/** 宿主鉴权由 DSH 的 connection.requestRejection 负责；保留原页面的请求头写法以降低改动。 */
export const CONFIRMATION_HEADER = "x-zero-db-tool-token";
export function confirmationToken(): string {
	return "dsh";
}
