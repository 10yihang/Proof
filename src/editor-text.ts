/**
 * 编辑器保存时的行尾还原：读取时记录磁盘 EOL，保存前把编辑器内容转回，
 * 避免 CRLF 仓库一次保存产生全文件行尾噪声 diff。
 */
export function toDiskEol(text: string, eol: "lf" | "crlf"): string {
  if (eol !== "crlf") return text;
  // 先归一为 \n 再统一转回，保证幂等（内容里已有 \r\n 时不会双重转换）。
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

/** 状态栏文件大小：B / KB / MB（小于 10 时保留一位小数）。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
