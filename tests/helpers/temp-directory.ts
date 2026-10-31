import { mkdtemp, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/** Canonicalize only the OS root used to create fresh synthetic test data. */
export async function makeTestDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}
