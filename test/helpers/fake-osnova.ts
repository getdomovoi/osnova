import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// A second osnova install on disk, as setup sees one: a package whose package.json names @getdomovoi/osnova, its
// dist/bin.js, and an `osnova` shim linking to it. Setup and uninstall check a launch path against the package on disk,
// so tests of "another install" need a real one. Created once per test file and left to the OS temp cleaner.
let install: Promise<{ readonly bin: string; readonly shim: string }> | undefined;
export function fakeOsnovaInstall(): Promise<{ readonly bin: string; readonly shim: string }> {
  install ??= (async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-fake-install-")));
    const pkg = path.join(root, "lib", "node_modules", "@getdomovoi", "osnova");
    await fs.mkdir(path.join(pkg, "dist"), { recursive: true });
    await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@getdomovoi/osnova" }));
    const bin = path.join(pkg, "dist", "bin.js");
    await fs.writeFile(bin, "#!/usr/bin/env node\n");
    await fs.mkdir(path.join(root, "bin"), { recursive: true });
    // Windows needs extra rights for links; there the shim is the bin.js path itself, still another install's path.
    const link = path.join(root, "bin", "osnova");
    const shim = await fs.symlink(bin, link).then(() => link, () => bin);
    return { bin, shim };
  })();
  return install;
}
