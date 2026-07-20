#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

/**
 * stdio entry point. Nothing may be written to stdout except protocol frames,
 * so any diagnostics go to stderr.
 */
/**
 * Where `.repros/` lives. Defaults to the directory the client launched us in,
 * which is wrong whenever the repros are kept outside the project being fixed.
 */
const root = process.env.REPLAY_ROOT ?? process.cwd();
const server = createServer(root);
await server.connect(new StdioServerTransport());
process.stderr.write(`replay mcp server ready (repros: ${root})\n`);
