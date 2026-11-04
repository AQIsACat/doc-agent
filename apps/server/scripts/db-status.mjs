import 'dotenv/config';
import { Client } from 'pg';

const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

await client.connect();

const { rows } = await client.query(
  'SELECT id, name, run_on FROM pgmigrations ORDER BY id',
);

if (rows.length === 0) {
  console.log('No migrations applied.');
} else {
  console.table(rows);
}

await client.end();