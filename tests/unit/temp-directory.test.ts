import { lstat, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname } from "path";
import { makeTestDirectory } from "../helpers/temp-directory";

test("fresh synthetic directories use the canonical OS temporary root", async () => {
  const directory = await makeTestDirectory("canonical-test-root-");
  try {
    expect(dirname(directory)).toBe(await realpath(tmpdir()));
    expect(await realpath(directory)).toBe(directory);
    expect(basename(directory)).toMatch(/^canonical-test-root-/);
    expect((await lstat(directory)).isSymbolicLink()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
