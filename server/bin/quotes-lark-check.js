import { runLarkCommand } from '../src/quotations/lark-cli.js';

process.exitCode = await runLarkCommand({ check: true, args: process.argv.slice(2) });
