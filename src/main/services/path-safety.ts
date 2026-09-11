import path from "node:path";

export function assertWithinRoot(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }

  throw new Error("衍生檔路徑超出 App cache 安全範圍。");
}

export function assertSafeHexId(value: string, label = "ID"): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} 格式無效。`);
  }
  return value.toLowerCase();
}
