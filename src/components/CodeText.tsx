import {
  highlightedParts,
  whitespaceDecorationsAllowed,
  type TextRange,
} from "../diff-reading";

export function CodeText({
  text,
  search,
  ranges,
  showWhitespace,
}: {
  text: string;
  search: string;
  ranges?: TextRange[];
  showWhitespace: boolean;
}) {
  const parts = highlightedParts(text, ranges, search);
  const whitespace = showWhitespace && whitespaceDecorationsAllowed(text);
  const simplified =
    parts.some((part) => part.simplified) || (showWhitespace && !whitespace);
  return (
    <span
      title={
        simplified
          ? "此行使用简化高亮；原始代码完整保留，可正常选择和复制。"
          : undefined
      }
    >
      {parts.map((part, index) => (
        <span
          key={index}
          className={
            [
              part.syntax,
              part.changed ? "inline-change" : "",
              part.matched ? "search-match" : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
        >
          {whitespace
            ? part.text.split(/([ \t\r])/g).map((piece, n) =>
                /[ \t\r]/.test(piece) && piece.length === 1 ? (
                  <span
                    key={n}
                    className={
                      piece === " "
                        ? "visible-space"
                        : piece === "\t"
                          ? "visible-tab"
                          : piece === "\r"
                            ? "visible-cr"
                            : undefined
                    }
                  >
                    {piece}
                  </span>
                ) : (
                  piece
                ),
              )
            : part.text}
        </span>
      ))}
    </span>
  );
}
