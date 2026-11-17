// Builds tmp/test-cdn once, before any Playwright worker starts.
// (makeCdn() wipes and rewrites the directory, so it must not run per worker.)
import { makeCdn } from "./fixtures/make-cdn.mjs";

export default function globalSetup() {
  makeCdn();
}
