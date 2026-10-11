import { buildApp } from './app.ts';
import { SEED_CREATORS, insertCreators, openDatabase } from './db.ts';

const db = openDatabase(process.env.DATABASE_PATH ?? 'sales.db');
insertCreators(db, SEED_CREATORS);

const app = buildApp(db);
const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: '127.0.0.1' }).then((address) => {
  console.log(`ouvindo em ${address}`);
});
