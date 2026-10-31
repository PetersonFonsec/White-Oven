/**
 * Runs inside `eas env:exec <environment>` (ADR 0028): checks the `WHITEOVEN_API_URL` the EAS
 * environment would hand the build, with the same rule as the worker. Prints only which rule
 * failed, never the value. Exit 3 means the address is missing or invalid. Under `release-check
 * --eas` this output is discarded with the rest of the EAS CLI's; only the exit status counts.
 *
 * With `WHITEOVEN_RELEASE=store` it also asks that API for the store's legal documents
 * (ADR 0030): exit 4 means the privacy policy or the terms of use are missing or still
 * demonstration text.
 */
import {
  apiUrlReleaseProblems,
  fetchLegalReleaseProblems,
} from "../src/config/release.ts";

const url = process.env.WHITEOVEN_API_URL;
const problems = apiUrlReleaseProblems(url);
for (const problem of problems) console.error(`- ${problem}`);
if (problems.length) process.exit(3);
if (process.env.WHITEOVEN_RELEASE === "store") {
  const legal = await fetchLegalReleaseProblems(
    url!,
    process.env.WHITEOVEN_TENANT ?? "",
  );
  for (const problem of legal) console.error(`- ${problem}`);
  if (legal.length) process.exit(4);
}
process.exit(0);
