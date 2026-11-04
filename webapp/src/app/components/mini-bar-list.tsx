export function MiniBarList({
  entries,
  emptyText = '暂无数据',
  formatKey
}: {
  entries: Array<[string, number]>;
  emptyText?: string;
  formatKey?: (key: string) => string;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  const max = Math.max(1, ...entries.map(([, count]) => count));
  return (
    <div className="space-y-2">
      {entries.map(([key, count]) => (
        <div key={key} className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-mono text-muted-foreground" title={key}>
              {formatKey ? formatKey(key) : key}
            </span>
            <span className="shrink-0 tabular-nums">{count}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${Math.max(3, (count / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
