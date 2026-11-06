import { runLarkCommand } from '../src/quotations/lark-cli.js';

process.exitCode = await runLarkCommand({ args: process.argv.slice(2) });
