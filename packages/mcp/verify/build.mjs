import { access } from "node:fs/promises";

for (const entry of ["dist/index.js", "dist/stdio.js"]) await access(new URL(`../${entry}`, import.meta.url));
console.log("MCP build artifacts are present");
