import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Симулируем ситуацию на Windows — URL неправильный
const transport = new StdioClientTransport({
  command: 'node',
  args: ['/root/ragmir-mcp-server/upload-client/upload-client.mjs'],
  env: { RAGMIR_UPLOAD_URL: 'http://localhost:9999/upload' },  // неправильный URL
});
const client = new Client({ name: 'test', version: '1.0.0' });
await client.connect(transport);
const result = await client.callTool({
  name: 'upload_to_ragmir',
  arguments: { project: 'test-upload', path: 't.bin', localPath: '/tmp/test-file.bin' },
});
console.log('Result:', JSON.stringify(result.content));
await transport.close();
process.exit(0);
