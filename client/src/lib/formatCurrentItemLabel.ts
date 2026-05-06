const PIPELINE_QUEUE_PROGRESS_PATTERN = /^第\s*(\d+)\s*\/\s*(\d+)\s*章\s*[·•]\s*(.+)$/u;

export interface CurrentItemLabelParts {
  queueIndex: number;
  queueTotal: number;
  title: string;
}

export function parseCurrentItemLabel(label: string | null | undefined): CurrentItemLabelParts | null {
  const normalized = label?.trim();
  if (!normalized) {
    return null;
  }

  const match = normalized.match(PIPELINE_QUEUE_PROGRESS_PATTERN);
  if (!match) {
    return null;
  }

  return {
    queueIndex: Number(match[1]),
    queueTotal: Number(match[2]),
    title: match[3].trim(),
  };
}

export function formatCurrentItemLabel(label: string | null | undefined): string | null {
  const normalized = label?.trim();
  if (!normalized) {
    return null;
  }

  const parsed = parseCurrentItemLabel(normalized);
  if (!parsed) {
    return normalized;
  }

  const trimmedTitle = parsed.title.trim();
  if (!trimmedTitle) {
    return `本轮队列 ${parsed.queueIndex}/${parsed.queueTotal}`;
  }

  return `${trimmedTitle}（本轮队列 ${parsed.queueIndex}/${parsed.queueTotal}）`;
}
