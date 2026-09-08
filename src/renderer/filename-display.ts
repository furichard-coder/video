export type FilenameDisplayPriority = "START" | "END";

interface FilenameSignature {
  prefix: string;
  date: string;
  numericOnly: boolean;
  length: number;
}

function signature(fileName: string): FilenameSignature {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const prefix = (stem.match(/^[^0-9]*/)?.[0] ?? "").replace(/[\s_.-]+/g, "").toLocaleLowerCase();
  const date = (stem.match(/(?:^|[^0-9])((?:19|20)\d{2}(?:[\s_.-]?(?:0[1-9]|1[0-2])(?:[\s_.-]?(?:0[1-9]|[12]\d|3[01]))?)?)/)?.[1] ?? "").replace(/[^0-9]/g, "");
  return { prefix, date, numericOnly: /^\d+$/.test(stem), length: stem.length };
}

function sameSequenceFamily(current: FilenameSignature, neighbor: FilenameSignature): boolean {
  if (current.numericOnly || neighbor.numericOnly) return current.numericOnly && neighbor.numericOnly && current.length === neighbor.length;
  if (!current.prefix && !current.date) return false;
  return current.prefix === neighbor.prefix && current.date === neighbor.date;
}

export function filenameDisplayPriority(fileName: string, neighboringFileNames: Array<string | undefined>): FilenameDisplayPriority {
  const neighbors = neighboringFileNames.filter((name): name is string => Boolean(name));
  if (!neighbors.length) return "START";
  const current = signature(fileName);
  return neighbors.every((neighbor) => sameSequenceFamily(current, signature(neighbor))) ? "END" : "START";
}
