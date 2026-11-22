#!/usr/bin/env node
"use strict";
// `npx -y @slicevm/mcp [flags]` runs `slice mcp [flags]` over stdio.
// Flags are passed through unchanged; `--audit-egress=auto` is handled by the runtime itself.
const { runBinary } = require("@slicevm/cli");

runBinary(["mcp", ...process.argv.slice(2)]);
