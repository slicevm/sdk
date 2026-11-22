#!/usr/bin/env node
"use strict";
// `npx @slicevm/cli ...` and the `slice` command: run the native binary for this platform.
require("../lib/index.js").runBinary(process.argv.slice(2));
