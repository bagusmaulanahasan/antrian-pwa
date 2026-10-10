/**
 * Re-export fixture test sebagai modul TypeScript.
 *
 * Fixture aslinya ada di scripts/test-fixtures.mjs (dipakai juga oleh mock).
 * File ini hanya adapter supaya unit test Worker mendapat tipe yang benar.
 */
export { TEST_HASH, TEST_PASSWORD } from '../../scripts/test-fixtures.mjs'