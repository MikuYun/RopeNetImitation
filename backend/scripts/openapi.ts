import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.ts';

const { app } = await buildApp({ databasePath: ':memory:', logger: false });
try {
  await writeFile('openapi.json', `${JSON.stringify(app.swagger(), null, 2)}\n`);
  console.log('Generated openapi.json');
} finally {
  await app.close();
}
