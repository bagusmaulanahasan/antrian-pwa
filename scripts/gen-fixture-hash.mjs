/** Hitung hash argon2id untuk fixture mock. Jalankan: node scripts/gen-fixture-hash.mjs <password> */
import { hashPassword } from '../worker/src/lib/password.ts'

const password = process.argv[2] ?? 'WorkerTest123!'
console.log(await hashPassword(password))