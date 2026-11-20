import { assertLoopbackTestDb } from './loopback-test-db.mjs';

// Validate the initial environment before dotenv or transitive app imports.
// Pin the validated URL so legacy dotenv override calls and child processes
// cannot silently switch to a different (possibly production) database.
const url = assertLoopbackTestDb();
process.env = new Proxy(process.env, {
  set(target, key, value) {
    if (typeof key === 'string' && key.toUpperCase() === 'DATABASE_URL') {
      if (value !== url) throw new Error('Refusing to override the loopback test DATABASE_URL.');
      return true;
    }
    return Reflect.set(target, key, value);
  },
  deleteProperty(target, key) {
    if (typeof key === 'string' && key.toUpperCase() === 'DATABASE_URL') throw new Error('Refusing to unset the loopback test DATABASE_URL.');
    return Reflect.deleteProperty(target, key);
  },
});
