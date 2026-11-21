import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveUploadPath } from "../upload.js";

describe("resolveUploadPath", () => {
  let base: string;
  let allowed: string;
  let outside: string;

  before(async () => {
    base = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "edup-"));
    allowed = join(base, "allowed");
    await mkdir(allowed);
    await writeFile(join(allowed, "ok.txt"), "hi");
    outside = join(base, "secret.txt");
    await writeFile(outside, "nope");
    await symlink(outside, join(allowed, "link.txt"));
  });
  after(() => rm(base, { recursive: true, force: true }));

  it("is disabled without an upload dir", async () => {
    await assert.rejects(() => resolveUploadPath(join(allowed, "ok.txt"), undefined, 100), /disabled/);
  });

  it("allows a file inside the dir", async () => {
    const p = await resolveUploadPath(join(allowed, "ok.txt"), allowed, 100);
    assert.match(p, /ok\.txt$/);
  });

  it("rejects .. escapes", async () => {
    await assert.rejects(() => resolveUploadPath(join(allowed, "..", "secret.txt"), allowed, 100), /outside/);
  });

  it("rejects symlinks pointing outside", async () => {
    await assert.rejects(() => resolveUploadPath(join(allowed, "link.txt"), allowed, 100), /outside/);
  });

  it("rejects a sibling dir sharing the prefix", async () => {
    const sibling = allowed + "-evil";
    await mkdir(sibling);
    await writeFile(join(sibling, "x.txt"), "x");
    await assert.rejects(() => resolveUploadPath(join(sibling, "x.txt"), allowed, 100), /outside/);
  });

  it("rejects directories and oversized files", async () => {
    await assert.rejects(() => resolveUploadPath(allowed, allowed, 100), /regular file/);
    await assert.rejects(() => resolveUploadPath(join(allowed, "ok.txt"), allowed, 1), /too large/);
  });
});
