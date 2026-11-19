'use strict';

// Source checkouts can start offline once npm ci has finished.
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const installer = join(__dirname, '..', 'node_modules', 'electron', 'install.js');
if (!process.env.ELECTRON_SKIP_BINARY_DOWNLOAD && existsSync(installer)) require(installer);
