#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

/**
 * stdio entry point. Nothing may be written to stdout except protocol frames,
 * so any diagnostics go to stderr.
 */
const server = createServer(process.cwd());
await server.connect(new StdioServerTransport());
process.stderr.write('replay mcp server ready\n');
